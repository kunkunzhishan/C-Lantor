# Long-task steer 事故总结与规则

日期：2026-05-24

## 事故背景

长任务 `lt_20260524_756e0e79` 的原始目标是：

- 继续做 upstream feature 级同步；
- 完成 `docs/upstream-sync-candidates.md` 中剩余的 P1/P2 feature；
- 修正误提交的 CodexLoop 项目描述；
- 最后验证并提交。

中途用户要求创建一个“同步编号 / cursor 文档”，用于下一次 upstream 同步时知道从哪里开始。这个请求本应作为旁路文档任务处理，不能改变长任务主线。

实际问题是：我把这个文档请求 steer 给了正在跑的 long-task，并且 steer 文案让长任务把注意力转到“维护 upstream cursor/编号文档”。结果长任务没有继续完成原始剩余 feature，主线被带偏。

## 已实际完成的内容

本轮已经落地并提交的内容：

| 本地提交 | 内容 |
| --- | --- |
| `c3368a4` | 完成 upstream P0 runtime sync：P0 1-8。 |
| `ce3d5f8` | 收紧 streaming control event，只接受行首 `LANTOR_EVENT`，避免正文示例误触发。 |
| `3900a4e` | 做了 activity feed unread-first/newest-first 排序和部分未读 UI 行为。 |
| `b1d7af7` | 修复相邻换行 control event：保持行首限制，同时允许换行分隔的多个事件被消费。 |
| `39a3b04` | 新增 upstream cursor/编号文档，并修正 README/package/Cargo 中误写的 CodexLoop 项目描述。 |

当前 long-task `lt_20260524_756e0e79` 已停止/完成，tracked 工作区干净，只剩 `.agent2long/` 和 `.agent2long-archive/` 运行态目录未跟踪。

## 未完成的 upstream 同步任务

这些任务仍未真正完成，不能因为 `lt_20260524_756e0e79` 完成而误判为已同步：

| 编号 | 优先级 | 未完成任务 |
| --- | --- | --- |
| F10 | P1 | thread feed 按最新回复排序。 |
| F11 | P1 | 频道创建/改名禁止重复名称。 |
| F12 | P1 | 桌面聊天滚动 bottom-follow 行为修复。 |
| F13 | P1 | 搜索结果 pane 关闭行为修复。 |
| F14 | P1 | 移动端图片预览与频道布局优化。 |
| F15 | P1 | thread 底部 follow 和 back-to-bottom 按钮位置优化。 |
| F16 | P2 | UI refresh metrics / diagnostics。 |
| F17 | P2 | 高频 stream/activity/run usage 更新批处理。这个和“UI 卡 / stream 卡”最相关。 |
| F18 | P2 | 4 档 UI 字号设置。 |

## Steering 规则

这些规则适用于所有 agent，不只适用于某个 agent 的个人记忆。

**任何 agent 使用 `long-task-steer` 前，必须先在当前线程向用户确认并拿到明确同意；没有确认就不要 steer。**

## 下一步建议

不要继续复用 `lt_20260524_756e0e79`。如果继续做剩余同步，应重新创建更窄的任务：

1. 先做 F17：高频 stream/activity/run usage 更新批处理，解决 UI/stream 卡顿风险。
2. 再做 F12 + F15：聊天和 thread 的 bottom-follow / back-to-bottom 行为。
3. 再做 F10 + F11 + F13 + F14。
4. 最后做 F16 + F18。

新任务说明必须明确：不维护 cursor 文档作为主线，不重新评估 `465be81..c79e648`，只处理上面剩余 feature。
