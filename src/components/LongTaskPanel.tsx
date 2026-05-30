import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, CircleStop, Plus, RefreshCw, Send, X } from "lucide-react";
import { apiInvoke } from "../apiClient";
import type { LongTaskChecklistItem, LongTaskCreateResult, LongTaskInspectDetail, LongTaskInspectResult, LongTaskListItem } from "../types";
import { formatTime } from "../ui-utils";
import { Modal } from "./Modal";

type LongTaskPanelProps = {
  refreshNonce: number;
  onError: (message: string) => void;
  onApprovalCountChange?: (count: number) => void;
};

type CreateForm = {
  title: string;
  workspace: string;
  task: string;
  maxLoops: string;
  approval: boolean;
  taskMode: "restart" | "continue";
};

const EMPTY_CREATE_FORM: CreateForm = {
  title: "",
  workspace: "",
  task: "",
  maxLoops: "20",
  approval: true,
  taskMode: "restart",
};

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

function renderRecentOutput(value: unknown) {
  if (value == null) return "No recent output yet.";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function valueFromRecord(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

function recordFromValue(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function recordList(value: unknown) {
  return Array.isArray(value)
    ? value.map(recordFromValue).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function displayValue(value: unknown) {
  if (value == null || value === "") return "-";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return renderRecentOutput(value);
}

function simpleFileName(value: string) {
  const markdownLink = value.match(/\[([^\]]+)\]\(([^)]+)\)/);
  if (markdownLink) return basenameForDisplay(markdownLink[1] || markdownLink[2]);
  const pathMatch = value.match(/(?:^|[^\w./-])((?:\/?[\w@.-]+\/)*[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?::\d+)?(?=[^\w./-]|$)/);
  if (pathMatch) return basenameForDisplay(pathMatch[1]);
  return "";
}

function basenameForDisplay(value: string) {
  const cleaned = value
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+(?:\.\d+)*\.?\s+/, "")
    .replace(/^`|`$/g, "")
    .replace(/[:#]\d+\)?$/, "")
    .replace(/[),.;:]+$/, "");
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : cleaned;
}

function renderOutputList(label: string, values: string[], className = "", key?: string) {
  if (values.length === 0) return null;
  return (
    <div key={key} className={`long-task-output-list ${className}`}>
      <span>{label}</span>
      <ul>
        {values.map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}
      </ul>
    </div>
  );
}

function outputDetailValues(input: {
  blockers: string[];
  decisions: string[];
  followUpRisks: string[];
  budgetRecovery: Record<string, unknown> | null;
}) {
  const values = [
    ...input.blockers.map((item) => `Blocker: ${item}`),
    ...input.decisions.map((item) => `Decision: ${item}`),
    ...input.followUpRisks.map((item) => `Risk: ${item}`),
  ];
  if (input.budgetRecovery) {
    const recovery = [
      displayValue(input.budgetRecovery.trigger),
      input.budgetRecovery.recoveryPath ? displayValue(input.budgetRecovery.recoveryPath) : "",
      input.budgetRecovery.fallbackReason ? displayValue(input.budgetRecovery.fallbackReason) : "",
    ].filter((item) => item && item !== "-").join(" · ");
    if (recovery) values.push(`Recovery: ${recovery}`);
  }
  return values;
}

function renderRecentOutputDetail(value: unknown) {
  if (value == null) return <p>No recent output yet.</p>;
  if (typeof value !== "object" || Array.isArray(value)) return <p>{renderRecentOutput(value)}</p>;
  const record = recordFromValue(value);
  const display = recordFromValue(record?.display);
  if (display) {
    const headline = display.headline;
    const outcome = display.outcome;
    const stats = recordList(display.stats);
    const sections = recordList(display.sections);
    const completedAt = display.completedAt;
    const hasStructuredSummary = stats.length > 0 || sections.length > 0;
    const outcomeText = typeof outcome === "string" && outcome.trim() ? outcome : "";
    return (
      <div className="long-task-output compact-summary">
        <div className="long-task-output-hero">
          <div>
            <span>Last Act Summary</span>
            <strong>{typeof headline === "string" && headline.trim() ? headline : "Recent output"}</strong>
          </div>
        </div>
        {!hasStructuredSummary ? <p className="long-task-output-summary">{outcomeText || "No summary yet."}</p> : null}
        {stats.length > 0 && (
          <div className="long-task-output-grid">
            {stats.map((stat, index) => (
              <span key={`${displayValue(stat.label)}-${index}`}>{displayValue(stat.label)} <strong>{displayValue(stat.value)}</strong></span>
            ))}
          </div>
        )}
        {sections.length > 0 && (
          <div className="long-task-output-columns">
            {sections.map((section, index) => renderOutputList(
              displayValue(section.title),
              stringList(section.items),
              section.tone === "danger" ? "danger" : section.tone === "warning" ? "warning" : "",
              `${displayValue(section.title)}-${index}`,
            ) ?? <div key={`empty-${index}`} />)}
          </div>
        )}
        {typeof completedAt === "string" && completedAt ? <small className="long-task-output-time">Completed {formatTime(completedAt)}</small> : null}
      </div>
    );
  }
  const summary = record?.summary;
  const actionTitle = record?.actionTitle;
  const changedFileList = stringList(record?.changedFiles).map(simpleFileName).filter(Boolean);
  const blockers = stringList(record?.blockers);
  const decisions = stringList(record?.decisions);
  const followUpRisks = stringList(record?.followUpRisks);
  const loop = record?.loop;
  const completedAt = record?.completedAt;
  const budgetRecovery = recordFromValue(record?.budgetRecovery);
  const codeChange = record?.codeChange;
  const changedFiles = valueFromRecord(codeChange, "changedFiles");
  const insertions = valueFromRecord(codeChange, "insertions");
  const deletions = valueFromRecord(codeChange, "deletions");
  const hasCodeLines = insertions != null || deletions != null;
  return (
    <div className="long-task-output">
      <div className="long-task-output-hero">
        <div>
          <span>Last Act</span>
          <strong>{typeof actionTitle === "string" && actionTitle.trim() ? actionTitle : "Recent output"}</strong>
        </div>
      </div>
      <p className="long-task-output-summary">{typeof summary === "string" && summary.trim() ? summary : "No summary yet."}</p>
      <div className="long-task-output-grid">
        <span>Loop <strong>{displayValue(loop)}</strong></span>
        <span>Files <strong>{displayValue(changedFiles)}</strong></span>
        {hasCodeLines ? <span>Code lines <strong>+{displayValue(insertions)} / -{displayValue(deletions)}</strong></span> : null}
      </div>
      <div className="long-task-output-columns">
        {renderOutputList("Changed Files", changedFileList)}
        {renderOutputList("Details", outputDetailValues({ blockers, decisions, followUpRisks, budgetRecovery }), blockers.length > 0 ? "danger" : followUpRisks.length > 0 || budgetRecovery ? "warning" : "")}
      </div>
      {typeof completedAt === "string" && completedAt ? <small className="long-task-output-time">Completed {formatTime(completedAt)}</small> : null}
    </div>
  );
}

function taskStatusClass(status?: string) {
  const normalized = normalizeLongTaskStatus(status);
  if (!normalized) return "unknown";
  if (normalized === "done" || normalized === "verified") return "done";
  if (normalized === "failed") return "failed";
  if (normalized === "stopped" || normalized === "stopping") return "stopped";
  if (normalized.includes("approval")) return "approval";
  if (normalized === "blocked") return "blocked";
  if (normalized === "not_reported") return "unknown";
  return "running";
}

function isTerminalStatus(status?: string) {
  return ["done", "failed", "stopped"].includes(normalizeLongTaskStatus(status));
}

function isEndedLongTask(item: LongTaskListItem) {
  return item.archived || isTerminalStatus(item.monitor?.status);
}

function statusLabel(status?: string | null) {
  const normalized = normalizeLongTaskStatus(status);
  return normalized && normalized !== "not_reported" ? displayLongTaskStatus(normalized) : "Not reported";
}

function normalizeLongTaskStatus(status?: string | null) {
  const value = status?.trim() ?? "";
  if (value.includes("完成")) return "done";
  if (value.includes("失败")) return "failed";
  if (value.includes("已停止")) return "stopped";
  if (value.includes("停止")) return "stopping";
  if (value.includes("批准")) return "approval";
  if (value.includes("阻塞")) return "blocked";
  if (value === "当前") return "current";
  return value;
}

function displayLongTaskStatus(status: string) {
  return status
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseProgressPercent(progress?: string | null) {
  if (!progress) return null;
  const match = progress.match(/^\s*(\d+)\s*\/\s*(\d+)\s*$/);
  if (!match) return null;
  const done = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function detailActions(detail: LongTaskInspectDetail | null) {
  return detail?.actions ?? {};
}

function basename(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || path || "Workspace";
}

function dirname(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return path || "/";
  return `${path.startsWith("/") ? "/" : ""}${parts.slice(0, -1).join("/")}`;
}

function groupLongTasks(items: LongTaskListItem[]) {
  const groups = new Map<string, LongTaskListItem[]>();
  for (const item of items) {
    const group = groups.get(item.workspace) ?? [];
    group.push(item);
    groups.set(item.workspace, group);
  }
  return Array.from(groups.entries()).map(([workspace, tasks]) => ({
    workspace,
    label: basename(workspace),
    parent: dirname(workspace),
    activeTasks: tasks.filter((item) => !isEndedLongTask(item)),
    endedTasks: tasks.filter(isEndedLongTask),
    activeCount: tasks.filter((item) => !isEndedLongTask(item)).length,
  }));
}

function currentChecklistRefs(items: LongTaskChecklistItem[]): string[] {
  const refs: string[] = [];
  const visit = (nodes: LongTaskChecklistItem[]) => {
    for (const node of nodes) {
      if (normalizeLongTaskStatus(node.status) === "current") refs.push(node.id || node.title || "current");
      visit(node.children ?? []);
    }
  };
  visit(items);
  return refs;
}

function renderChecklistTree(items: LongTaskChecklistItem[], depth = 0) {
  return (
    <ul className={`long-task-checklist-tree depth-${depth}`}>
      {items.map((item, index) => {
        const statusClass = taskStatusClass(item.status);
        const children = item.children ?? [];
        return (
          <li key={`${item.id ?? depth}-${index}`} className={`long-task-check-node ${children.length ? "has-children" : ""}`}>
            <div className={`long-task-check-row ${statusClass}`}>
              <span className="long-task-check-id">{item.id || `${index + 1}`}</span>
              <span className="long-task-check-title">{item.title ?? "Untitled"}</span>
              <span className="long-task-check-meta">
                {item.progress ? <strong>{item.progress}</strong> : null}
                {item.status ? <em>{statusLabel(item.status)}</em> : null}
              </span>
            </div>
            {children.length > 0 ? renderChecklistTree(children, depth + 1) : null}
          </li>
        );
      })}
    </ul>
  );
}

function renderApprovalDetail(detail: LongTaskInspectDetail | null) {
  const approval = detail?.approval;
  if (!approval || approval.status !== "pending") return null;
  const checklistIds = Array.isArray(approval.checklistItemIds) ? approval.checklistItemIds : [];
  return (
    <div className="long-task-section">
      <h4>Pending Approval</h4>
      <p>{approval.title || "Pending action"}</p>
      {approval.instructions ? <pre>{approval.instructions}</pre> : null}
      <div className="long-task-metrics">
        <span>Loop <strong>{approval.loop ?? "-"}</strong></span>
        <span>Requested <strong>{approval.requestedAt ? formatTime(approval.requestedAt) : "-"}</strong></span>
      </div>
      {checklistIds.length > 0 ? <p>Checklist: {checklistIds.join(", ")}</p> : null}
    </div>
  );
}

export function LongTaskPanel({ refreshNonce, onError, onApprovalCountChange }: LongTaskPanelProps) {
  const [items, setItems] = useState<LongTaskListItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<LongTaskInspectResult | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>(EMPTY_CREATE_FORM);
  const [steerText, setSteerText] = useState("");
  const [rejectText, setRejectText] = useState("");
  const [expandedEndedGroups, setExpandedEndedGroups] = useState<Set<string>>(() => new Set());

  const activeItems = useMemo(() => items.filter((item) => !isEndedLongTask(item)), [items]);
  const groupedItems = useMemo(() => groupLongTasks(items), [items]);
  const endedItems = items.length - activeItems.length;
  const approvalItems = useMemo(() => items.filter((item) => !item.archived && taskStatusClass(item.monitor?.status) === "approval").length, [items]);

  useEffect(() => {
    onApprovalCountChange?.(approvalItems);
  }, [approvalItems, onApprovalCountChange]);

  async function loadList() {
    setLoadingList(true);
    try {
      const next = await apiInvoke<LongTaskListItem[]>("long_task_list");
      setItems(next);
      setSelectedId((current) => current ?? next.find((item) => !isEndedLongTask(item))?.id ?? next[0]?.id ?? null);
    } catch (err) {
      onError(errorMessage(err, "Failed to load long tasks"));
    } finally {
      setLoadingList(false);
    }
  }

  async function loadDetail(taskId: string) {
    setLoadingDetail(true);
    try {
      const detail = await apiInvoke<LongTaskInspectResult>("long_task_inspect", { taskId });
      setSelected(detail);
    } catch (err) {
      onError(errorMessage(err, "Failed to inspect long task"));
    } finally {
      setLoadingDetail(false);
    }
  }

  useEffect(() => {
    loadList();
  }, [refreshNonce]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      loadList();
      if (selectedId) loadDetail(selectedId);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    loadDetail(selectedId);
  }, [selectedId, refreshNonce]);

  async function createTask() {
    const maxLoops = Number(createForm.maxLoops || "20");
    if (!Number.isInteger(maxLoops) || maxLoops < 1) {
      onError("maxLoops must be a positive integer");
      return;
    }
    try {
      const result = await apiInvoke<LongTaskCreateResult>("long_task_create", {
        title: createForm.title,
        workspace: createForm.workspace,
        task: createForm.task,
        maxLoops,
        approval: createForm.approval,
        taskMode: createForm.taskMode,
      });
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE_FORM);
      setSelectedId(result.id);
      await loadList();
    } catch (err) {
      onError(errorMessage(err, "Failed to create long task"));
    }
  }

  async function runControl(command: string, args: Record<string, unknown>) {
    if (!selectedId) return;
    try {
      await apiInvoke(command, args);
      await loadList();
      await loadDetail(selectedId);
    } catch (err) {
      onError(errorMessage(err, `${command} failed`));
    }
  }

  async function sendSteer() {
    if (!selectedId || !steerText.trim()) return;
    const instruction = steerText.trim();
    setSteerText("");
    await runControl("long_task_steer", { taskId: selectedId, instruction });
  }

  async function rejectTask() {
    if (!selectedId || !rejectText.trim()) return;
    const reason = rejectText.trim();
    setRejectText("");
    await runControl("long_task_reject", { taskId: selectedId, reason });
  }

  function toggleEndedGroup(workspace: string) {
    setExpandedEndedGroups((current) => {
      const next = new Set(current);
      if (next.has(workspace)) {
        next.delete(workspace);
      } else {
        next.add(workspace);
      }
      return next;
    });
  }

  const selectedListItem = items.find((item) => item.id === selectedId) ?? null;
  const monitor = selected?.monitor ?? selectedListItem?.monitor ?? null;
  const detail = selected?.detail ?? null;
  const actions = detailActions(detail);
  const currentText = monitor?.current || detail?.currentJudgment || "-";
  const checklistRefs = currentChecklistRefs(detail?.checklist ?? []);
  const selectedStatusClass = taskStatusClass(monitor?.status);

  function renderLongTaskRow(item: LongTaskListItem, index: number, mode: "live" | "ended") {
    const statusClass = item.archived ? "done" : taskStatusClass(item.monitor?.status);
    const statusText = item.archived ? "Archived" : statusLabel(item.monitor?.status);
    const progressPercent = parseProgressPercent(item.monitor?.progress);
    const updatedAt = item.monitor?.updatedAt ? formatTime(item.monitor.updatedAt) : item.createdAt ? formatTime(item.createdAt) : "-";
    return (
      <button
        type="button"
        key={item.id}
        className={`long-task-row ${statusClass} ${mode} ${item.id === selectedId ? "active" : ""} ${item.archived ? "archived" : ""}`}
        onClick={() => setSelectedId(item.id)}
      >
        <span className={`long-task-status ${statusClass}`} />
        <span className="long-task-row-main">
          <strong><span className="long-task-row-index">{index + 1}</span><b>{item.title}</b></strong>
          <span className="long-task-row-meta">
            <span className={`long-task-mini-pill ${statusClass}`}>{statusText}</span>
            <time>{updatedAt}</time>
            {item.archived ? <em>Archived</em> : null}
          </span>
          <small>{item.id}</small>
          <em>{item.archived ? "Archived: newer long task in same workspace." : item.monitor?.current || item.error || item.workspace}</em>
        </span>
        <span className="long-task-progress-cell">
          <strong>{item.monitor?.progress ?? "-"}</strong>
          <span className="long-task-progress-track" aria-hidden="true">
            <span style={{ width: `${progressPercent ?? 0}%` }} />
          </span>
        </span>
      </button>
    );
  }

  return (
    <>
        <section className="long-task-panel long-task-page" aria-label="Long tasks">
          <header className="long-task-head">
            <div>
              <h2>Long Tasks</h2>
              <span>{items.length ? `${items.length} registered · ${activeItems.length} active` : "No registered tasks"}</span>
            </div>
            <div className="long-task-head-actions">
              <button type="button" onClick={loadList} title="Refresh" aria-label="Refresh long tasks">
                <RefreshCw size={16} />
              </button>
              <button type="button" onClick={() => setCreateOpen(true)} title="Create" aria-label="Create long task">
                <Plus size={16} />
              </button>
            </div>
          </header>

          <section className="long-task-summary" aria-label="Long task summary">
            <div className="active">
              <span>Active</span>
              <strong>{activeItems.length}</strong>
            </div>
            <div className="approval">
              <span>Approval</span>
              <strong>{approvalItems}</strong>
            </div>
            <div className="ended">
              <span>Ended</span>
              <strong>{endedItems}</strong>
            </div>
          </section>

          <div className="long-task-body">
            <section className="long-task-list" aria-label="Long task list">
              {loadingList && items.length === 0 ? <p className="long-task-empty">Loading tasks...</p> : null}
              {!loadingList && items.length === 0 ? <p className="long-task-empty">Create a long task to start tracking CodexLoop work.</p> : null}
              {groupedItems.map((group) => (
                <div className="long-task-group" key={group.workspace}>
                  <div className="long-task-group-head">
                    <div>
                      <strong>{group.label}</strong>
                      <span title={group.workspace}>{group.parent}</span>
                    </div>
                    <em>{group.activeTasks.length + group.endedTasks.length} tasks{group.activeCount ? ` / ${group.activeCount} active` : ""}</em>
                  </div>
                  <div className="long-task-group-tree">
                    {group.activeTasks.map((item, index) => renderLongTaskRow(item, index, "live"))}
                    {group.endedTasks.length > 0 && (
                      <div className="long-task-ended-block">
                        <button
                          type="button"
                          className="long-task-ended-toggle"
                          onClick={() => toggleEndedGroup(group.workspace)}
                          aria-expanded={expandedEndedGroups.has(group.workspace)}
                        >
                          <ChevronDown size={14} />
                          <span>Ended tasks</span>
                          <strong>{group.endedTasks.length}</strong>
                        </button>
                        {expandedEndedGroups.has(group.workspace) && group.endedTasks.map((item, index) => renderLongTaskRow(item, index, "ended"))}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </section>

            <section className="long-task-detail" aria-label="Long task detail">
              {!selectedId ? (
                <p className="long-task-empty">Select a task to inspect it.</p>
              ) : loadingDetail && !selected ? (
                <p className="long-task-empty">Loading detail...</p>
              ) : (
                <>
                  <div className="long-task-detail-top">
                    <div>
                      <h3>{selected?.title ?? selectedListItem?.title ?? selectedId}</h3>
                      <span>{selected?.workspace ?? selectedListItem?.workspace}</span>
                    </div>
                    <strong className={`long-task-pill ${selectedStatusClass}`}>{statusLabel(monitor?.status)}</strong>
                  </div>

                  <div className="long-task-metrics">
                    <span>Loop <strong>{monitor?.loopCount ?? detail?.loopCount ?? "-"}</strong></span>
                    <span>Progress <strong>{monitor?.progress ?? "-"}</strong></span>
                    <span>Updated <strong>{monitor?.updatedAt ? formatTime(monitor.updatedAt) : "-"}</strong></span>
                  </div>

                  <div className="long-task-section">
                    <h4>1. Current</h4>
                    <div className="long-task-current-panel">
                      <div>
                        <p>{currentText}</p>
                        {checklistRefs.length > 0 ? <small>Checklist {checklistRefs.join(", ")}</small> : null}
                      </div>
                    </div>
                  </div>

                  <div className="long-task-section">
                    <h4>2. Recent Output</h4>
                    {renderRecentOutputDetail(detail?.recentOutput)}
                  </div>

                  {Array.isArray(detail?.checklist) && detail.checklist.length > 0 && (
                    <div className="long-task-section">
                      <h4>3. Checklist</h4>
                      <div className="long-task-checklist-panel">
                        {renderChecklistTree(detail.checklist)}
                      </div>
                    </div>
                  )}

                  {Array.isArray(detail?.risks) && detail.risks.length > 0 && (
                    <div className="long-task-section">
                      <h4>Risks</h4>
                      {detail.risks.map((risk) => <p key={risk}>{risk}</p>)}
                    </div>
                  )}

                  {renderApprovalDetail(detail)}

                  <div className="long-task-control">
                    <textarea
                      value={steerText}
                      onChange={(event) => setSteerText(event.target.value)}
                      placeholder="Add steering instruction"
                    />
                    <button type="button" onClick={sendSteer} disabled={!steerText.trim()}>
                      <Send size={15} />
                      <span>Steer</span>
                    </button>
                  </div>

                  <div className="long-task-actions">
                    <button type="button" onClick={() => runControl("long_task_approve", { taskId: selectedId })} disabled={!actions.canApprove}>
                      <Check size={15} />
                      <span>Approve</span>
                    </button>
                    <button type="button" onClick={() => runControl("long_task_approval", { taskId: selectedId, mode: "auto" })} disabled={!actions.canSetApprovalMode}>
                      <ChevronDown size={15} />
                      <span>Auto</span>
                    </button>
                    <button type="button" onClick={() => runControl("long_task_stop", { taskId: selectedId })} disabled={!actions.canStop}>
                      <CircleStop size={15} />
                      <span>Stop</span>
                    </button>
                  </div>

                  <div className="long-task-control compact">
                    <input
                      value={rejectText}
                      onChange={(event) => setRejectText(event.target.value)}
                      placeholder="Reject reason"
                    />
                    <button type="button" onClick={rejectTask} disabled={!actions.canReject || !rejectText.trim()}>
                      <X size={15} />
                      <span>Reject</span>
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>
        </section>

      <Modal
        open={createOpen}
        title="Create Long Task"
        width={620}
        onClose={() => setCreateOpen(false)}
      >
        <form className="modal-form" onSubmit={(event) => {
          event.preventDefault();
          createTask();
        }}>
          <label>
            <span>Title</span>
            <input value={createForm.title} onChange={(event) => setCreateForm({ ...createForm, title: event.target.value })} />
          </label>
          <label>
            <span>Workspace</span>
            <input value={createForm.workspace} onChange={(event) => setCreateForm({ ...createForm, workspace: event.target.value })} placeholder="/absolute/path/to/project" />
          </label>
          <label>
            <span>Instruction</span>
            <textarea value={createForm.task} onChange={(event) => setCreateForm({ ...createForm, task: event.target.value })} rows={6} />
          </label>
          <div className="long-task-create-grid">
            <label>
              <span>Max loops</span>
              <input value={createForm.maxLoops} onChange={(event) => setCreateForm({ ...createForm, maxLoops: event.target.value })} inputMode="numeric" />
            </label>
            <label>
              <span>Task mode</span>
              <select value={createForm.taskMode} onChange={(event) => setCreateForm({ ...createForm, taskMode: event.target.value as CreateForm["taskMode"] })}>
                <option value="restart">restart</option>
                <option value="continue">continue</option>
              </select>
            </label>
            <label className="long-task-checkbox">
              <input type="checkbox" checked={createForm.approval} onChange={(event) => setCreateForm({ ...createForm, approval: event.target.checked })} />
              <span>Require approval</span>
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
            <button className="primary" type="submit">Create</button>
          </div>
        </form>
      </Modal>
    </>
  );
}
