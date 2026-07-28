# Upstream 同步游标与编号

日期：2026-05-28

这个文件的目的不是复述“本次同步了什么”，而是给下一次同步提供稳定起点：

- 下次应该从哪个 upstream commit 之后开始看；
- 本次 upstream 检查窗口的编号是什么；
- 如果继续做 feature 级同步，应该怎么给新窗口编号。

详细 feature 评估仍看 `docs/upstream-sync-candidates.md`。

## 当前同步游标

| 字段 | 值 |
| --- | --- |
| 当前 upstream 仓库 | `https://github.com/chenzl25/lantor` |
| 当前 fork 仓库 | `xxhZs/lantor-long-task` |
| 当前同步窗口编号 | `USYNC-0019` |
| 本窗口开始点 | `4363d86` `Add thread expand and fold controls (#135)` |
| 本窗口结束点 / 下次起点 | `4e44dda` `fix(dev): pin vite dev server port` |
| upstream cursor 完整 SHA | `4e44ddaa6cdacd0543715cbd8326ae421f316cff` |
| 本窗口 upstream commit 数 | `3` 个 upstream-only commit，`3` 个非 merge commit |
| 本窗口处理方式 | 不 merge upstream；只筛选必要 feature，在 fork 架构内做等价实现 |
| 下次同步起点 | 从 `4e44dda` 之后的新 upstream commit 开始 |

## 下次同步怎么开始

先刷新 upstream：

```bash
git fetch https://github.com/chenzl25/lantor.git refs/heads/main:refs/remotes/upstream/main
```

然后只看当前 cursor 之后的新提交：

```bash
git log --oneline --decorate 4e44ddaa6cdacd0543715cbd8326ae421f316cff..upstream/main
git rev-list --left-right --count HEAD...upstream/main
```

如果 `upstream/main` 仍然等于 `4e44ddaa6cdacd0543715cbd8326ae421f316cff`，说明没有新的 upstream 同步窗口，不需要重新从旧窗口开始看。

如果 upstream 有新提交，创建下一个窗口：

| 新窗口字段 | 填法 |
| --- | --- |
| 窗口编号 | `USYNC-0020` |
| 开始点 | 本文件当前 `upstream cursor`，也就是 `4e44ddaa6cdacd0543715cbd8326ae421f316cff` |
| 结束点 | 新 fetch 到的 `upstream/main` HEAD |
| 评估范围 | `4e44ddaa6cdacd0543715cbd8326ae421f316cff..upstream/main` |
| 输出 | 新增一段窗口记录，并只评估这个范围里的新增 feature/优化 |

## 窗口编号规则

- `USYNC-0001`：第一次系统性评估 upstream 差异，范围 `465be81..c79e648`。
- `USYNC-0002`：第二次系统性评估 upstream 差异，范围 `c79e648..7fe2c45`。
- `USYNC-0003`：下一次 upstream 有新 commit 后，从 `7fe2c45` 之后开始。
- 后续递增：`USYNC-0004`、`USYNC-0005`。
- 每个窗口只记录“这个窗口看到了哪段 upstream commit”，不要把旧窗口重新编号。

## 本窗口候选编号规则

`docs/upstream-sync-candidates.md` 中的 1-18 是 `USYNC-0001` 内部的 feature 候选编号。以后如果有新窗口，建议使用复合编号，避免和旧编号混淆：

| 编号格式 | 含义 |
| --- | --- |
| `USYNC-0001-F01` 到 `USYNC-0001-F18` | 本轮已经评估出的 18 个候选 feature |
| `USYNC-0003-F01` | 下一轮窗口里的第 1 个新增候选 feature |
| `USYNC-0003-F02` | 下一轮窗口里的第 2 个新增候选 feature |

这样下一次同步时，不需要猜“之前看到哪了”：先看本文件的 `upstream cursor`，再从 cursor 之后建立新窗口和新候选编号。

## USYNC-0002 摘要

| 项 | 值 |
| --- | --- |
| upstream range | `c79e648..7fe2c45` |
| 候选 feature 编号 | `USYNC-0002-F01` 到 `USYNC-0002-F13` |
| 已完成重点 | mobile create channel / create agent / home return、thread 折叠滚动、activity/run upsert、publish gate、interrupted action、visible side-effect buffer |
| 剩余实现 | 无；当前 cursor 已推进到 `7fe2c45` |
| 注意事项 | 下次 upstream diff 应从 `7fe2c45` 之后开始；不要重复评估 `c79e648..7fe2c45`。 |

## 2026-06-17 每日检查记录

- 本次按最近已确认的上游同步点 `c6955075859ee22a44fb21afd54b0452799a30aa` 检查。
- `git fetch https://github.com/chenzl25/lantor.git refs/heads/main:refs/remotes/upstream/main` 后，`upstream/main` 仍为 `c6955075859ee22a44fb21afd54b0452799a30aa`。
- 范围 `c6955075859ee22a44fb21afd54b0452799a30aa..upstream/main` 为 0 个 commit；今天不创建新的 `USYNC-0016` feature 窗口。
- 当前工作树实际同步文档位于 `/Users/xxhx/new_sort/lantor-long-task/docs/`；提醒中的旧 `lantor-long-task-voice` 目录本机已不存在。

## 2026-06-18 每日检查记录

- 本次继续按最近已确认的上游同步点 `c6955075859ee22a44fb21afd54b0452799a30aa` 检查。
- `git fetch https://github.com/chenzl25/lantor.git refs/heads/main:refs/remotes/upstream/main` 后，`upstream/main` 仍为 `c6955075859ee22a44fb21afd54b0452799a30aa`。
- 范围 `c6955075859ee22a44fb21afd54b0452799a30aa..upstream/main` 为 0 个 commit；今天不创建新的 `USYNC-0016` feature 窗口。
- 当前工作树实际同步文档位于 `/Users/xxhx/new_sort/lantor-long-task/docs/`；提醒中的旧 `lantor-long-task-voice` 目录本机已不存在。

## 2026-06-19 每日检查记录

- 本次从 `c6955075859ee22a44fb21afd54b0452799a30aa` 检查到 `03a15b22983e4eeafb635d9028972b24809ed621`。
- 新增 6 个 upstream-only 非 merge commit：`def95db`、`7c6d93f`、`007140b`、`f31eb9f`、`ad2cda6`、`03a15b2`。
- 新增 feature 候选记录在 `docs/upstream-sync-candidates.md` 的 `USYNC-0016-F01` 到 `USYNC-0016-F04`。
- 当前 upstream cursor 已推进到 `03a15b22983e4eeafb635d9028972b24809ed621`，下次从 `03a15b2` 之后开始检查。
- 当前工作树实际同步文档位于 `/Users/xxhx/new_sort/lantor-long-task/docs/`；提醒中的旧 `lantor-long-task-voice` 目录本机已不存在。

## 2026-06-22 每日检查记录

- 本次从 `03a15b22983e4eeafb635d9028972b24809ed621` 检查到 `8251c349021df86fc1b8e7e1d29d3cf07a0530d2`。
- 新增 10 个 upstream-only 非 merge commit：`817bf0a`、`76afdf7`、`1ff2f47`、`2626120`、`cdc354a`、`641a417`、`ad84ba6`、`b9bd2f5`、`b97355e`、`8251c34`。
- 新增 feature 候选记录在 `docs/upstream-sync-candidates.md` 的 `USYNC-0017-F01` 到 `USYNC-0017-F06`。
- 当前 upstream cursor 已推进到 `8251c349021df86fc1b8e7e1d29d3cf07a0530d2`，下次从 `8251c34` 之后开始检查。
- 当前工作树实际同步文档位于 `/Users/xxhx/new_sort/lantor-long-task/docs/`；提醒中的旧 `lantor-long-task-voice` 目录本机已不存在。

## 2026-06-23 每日检查记录

- 本次从 `8251c349021df86fc1b8e7e1d29d3cf07a0530d2` 检查到 `4363d861d5878dbe31a009c85be9ce56cbc723c4`。
- 新增 1 个 upstream-only 非 merge commit：`4363d86`。
- 新增 feature 候选记录在 `docs/upstream-sync-candidates.md` 的 `USYNC-0018-F01`。
- 当前 upstream cursor 已推进到 `4363d861d5878dbe31a009c85be9ce56cbc723c4`，下次从 `4363d86` 之后开始检查。
- 当前工作树实际同步文档位于 `/Users/xxhx/new_sort/lantor-long-task/docs/`；提醒中的旧 `lantor-long-task-voice` 目录本机已不存在。

## 2026-06-24 每日检查记录

- 本次从 `4363d861d5878dbe31a009c85be9ce56cbc723c4` 检查到 `4e44ddaa6cdacd0543715cbd8326ae421f316cff`。
- 新增 3 个 upstream-only 非 merge commit：`b9db941`、`86f9d06`、`4e44dda`。
- 新增 feature/维护候选记录在 `docs/upstream-sync-candidates.md` 的 `USYNC-0019-F01` 到 `USYNC-0019-F03`。
- 当前 upstream cursor 已推进到 `4e44ddaa6cdacd0543715cbd8326ae421f316cff`，下次从 `4e44dda` 之后开始检查。
- 当前工作树实际同步文档位于 `/Users/xxhx/new_sort/lantor-long-task/docs/`；提醒中的旧 `lantor-long-task-voice` 目录本机已不存在。

## USYNC-0001 摘要

| 项 | 值 |
| --- | --- |
| upstream range | `465be81..c79e648` |
| 候选 feature 编号 | `USYNC-0001-F01` 到 `USYNC-0001-F18` |
| 已完成重点 | P0 `F01-F08` 已完成；`F09` activity feed 排序已提交 |
| 剩余实现 | 继续看 `docs/upstream-sync-candidates.md` 和当前长任务状态 |
| 注意事项 | 该窗口已被后续 `USYNC-0002` 推进；当前 upstream cursor 以上方“当前同步游标”为准。 |

## USYNC-0001 本地落地记录

这些是本 fork 为 `USYNC-0001` 已落地或补强的本地提交。它们不是新的 upstream cursor；当前 upstream cursor 以上方“当前同步游标”为准。

| 本地提交 | 对应内容 |
| --- | --- |
| `c3368a4` `Complete upstream P0 runtime sync` | 完成 P0 `F01-F08` 的 runtime 等价能力整合。 |
| `ce3d5f8` `Restrict streaming control events to line starts` | 收紧 streaming control event parser，避免普通文本中的 `LANTOR_EVENT` 被误识别。 |
| `3900a4e` `Sync activity feed ordering behavior` | 实现 `F09` activity feed unread-first/newest-first 排序及相关 UI 行为。 |
| `b1d7af7` `Handle adjacent streaming control events` | 补齐最新 parser 修复：保持 line-start 限制，同时支持换行相邻的 `LANTOR_EVENT` payload。 |
