import { Bookmark, Check, Circle, ExternalLink, Hash, ListTodo, MessageSquare, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Agent, OwnerProfile, SavedMessage, TodoItem } from "../types";
import { displayNameForSender, firstLines, formatTime, ownerAsAvatarAgent } from "../ui-utils";
import { AgentAvatar } from "./AgentAvatar";

type SavedMessagesModalProps = {
  open: boolean;
  items: SavedMessage[];
  todoItems: TodoItem[];
  agents: Agent[];
  ownerProfile: OwnerProfile;
  onOpenItem: (item: SavedMessage) => void;
  onOpenTodoItem: (item: TodoItem) => void;
  onUnsaveItem: (item: SavedMessage) => void;
  onToggleTodoDone: (item: TodoItem, done: boolean) => void;
  onDeleteTodo: (item: TodoItem) => void;
  onCreateTodo: (summary: string) => void | Promise<void>;
  onClose: () => void;
};

export function SavedMessagesModal({
  open,
  items,
  todoItems,
  agents,
  ownerProfile,
  onOpenItem,
  onOpenTodoItem,
  onUnsaveItem,
  onToggleTodoDone,
  onDeleteTodo,
  onCreateTodo,
  onClose,
}: SavedMessagesModalProps) {
  const [tab, setTab] = useState<"saved" | "todo">("saved");
  const [showDone, setShowDone] = useState(false);
  const [todoDraft, setTodoDraft] = useState("");
  const visibleTodoItems = useMemo(
    () => todoItems.filter((item) => showDone || !item.done_at),
    [todoItems, showDone],
  );
  const openTodoCount = todoItems.filter((item) => !item.done_at).length;

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function submitTodoDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const summary = todoDraft.trim();
    if (!summary) return;
    setTodoDraft("");
    await onCreateTodo(summary);
    setTab("todo");
  }

  return (
    <div className="search-backdrop" onClick={onClose}>
      <section className="activity-feed-panel saved-panel" onClick={(event) => event.stopPropagation()}>
        <header className="activity-feed-head">
          <button className="activity-feed-back" onClick={onClose} aria-label="Close saved messages">
            <X size={18} />
          </button>
          <div>
            <h2>Saved</h2>
            <p>{items.length} saved · {openTodoCount} todo</p>
          </div>
        </header>

        <div className="saved-tabs" role="tablist" aria-label="Saved views">
          <button
            type="button"
            className={tab === "saved" ? "active" : ""}
            onClick={() => setTab("saved")}
          >
            Saved
          </button>
          <button
            type="button"
            className={tab === "todo" ? "active" : ""}
            onClick={() => setTab("todo")}
          >
            Todo
          </button>
        </div>

        <div className="activity-feed-body">
          {tab === "saved" && items.length === 0 && (
            <div className="search-empty">
              <Bookmark size={34} />
              <h3>No saved messages</h3>
              <p>Use the message save action or right-click a message to track it here.</p>
            </div>
          )}

          {tab === "saved" && items.map((item) => {
            const Icon = item.thread_root_id ? MessageSquare : Hash;
            const senderName = displayNameForSender(item, ownerProfile);
            const senderAgent = item.sender_role === "owner"
              ? ownerAsAvatarAgent(ownerProfile)
              : agents.find((agent) => agent.display_name === item.sender_name || agent.handle === item.sender_name.replace(/^@/, "")) ?? null;
            return (
              <article
                key={item.id}
                className="activity-feed-row saved-row"
                onClick={() => onOpenItem(item)}
              >
                <span className="activity-feed-row-avatar" aria-hidden="true">
                  {senderAgent ? (
                    <AgentAvatar agent={senderAgent} size="md" showStatus={false} />
                  ) : (
                    <span className="search-result-fallback-avatar">{senderName.slice(0, 1) || "S"}</span>
                  )}
                </span>
                <div className="activity-feed-row-main">
                  <div className="activity-feed-row-meta">
                    <strong>{senderName || "Saved message"}</strong>
                    <span>#{item.channel_name}</span>
                    <time>{formatTime(item.message_created_at)}</time>
                    <em>{item.thread_root_id ? "thread" : "channel"}</em>
                  </div>
                  <h3>
                    <Icon size={18} />
                    {senderName || "Saved message"}
                  </h3>
                  <p>{firstLines(item.body, 3) || "Empty message"}</p>
                  <small>Open source</small>
                </div>
                <button
                  type="button"
                  className="activity-feed-check saved-unsave"
                  title="Unsave"
                  onClick={(event) => {
                    event.stopPropagation();
                    onUnsaveItem(item);
                  }}
                >
                  <X size={18} />
                </button>
              </article>
            );
          })}

          {tab === "todo" && (
            <>
              <div className="todo-panel-tools">
                <span>{openTodoCount} open</span>
                <label>
                  <input
                    type="checkbox"
                    checked={showDone}
                    onChange={(event) => setShowDone(event.target.checked)}
                  />
                  Show done
                </label>
              </div>

              <form className="todo-create-form" onSubmit={submitTodoDraft}>
                <input
                  value={todoDraft}
                  onChange={(event) => setTodoDraft(event.target.value)}
                  placeholder="Add a todo"
                  aria-label="Add a todo"
                />
                <button type="submit" disabled={!todoDraft.trim()}>
                  Add
                </button>
              </form>

              {visibleTodoItems.length === 0 && (
                <div className="search-empty">
                  <ListTodo size={34} />
                  <h3>No todo items</h3>
                  <p>Use the todo action next to a message to add it here.</p>
                </div>
              )}

              {visibleTodoItems.map((item) => {
                const done = Boolean(item.done_at);
                const hasSource = Boolean(item.message_id && item.channel_id);
                const Icon = item.thread_root_id ? MessageSquare : Hash;
                return (
                  <article
                    key={item.id}
                    className={`todo-row ${done ? "done" : ""} ${hasSource ? "" : "manual"}`}
                    onClick={() => {
                      if (hasSource) onOpenTodoItem(item);
                    }}
                  >
                    <button
                      type="button"
                      className="todo-done-button"
                      title={done ? "Mark open" : "Mark done"}
                      aria-label={done ? "Mark todo open" : "Mark todo done"}
                      aria-pressed={done}
                      onClick={(event) => {
                        event.stopPropagation();
                        onToggleTodoDone(item, !done);
                      }}
                    >
                      {done ? <Check size={14} /> : <Circle size={14} />}
                    </button>
                    <div className="todo-row-main">
                      <p>{item.summary || "Empty message"}</p>
                      <small>
                        {hasSource ? (
                          <>
                            <Icon size={12} />
                            #{item.channel_name}
                            {item.message_created_at && <time>{formatTime(item.message_created_at)}</time>}
                          </>
                        ) : (
                          <>
                            <ListTodo size={12} />
                            manual
                            <time>{formatTime(item.created_at)}</time>
                          </>
                        )}
                      </small>
                    </div>
                    {hasSource ? (
                      <button
                        type="button"
                        className="todo-source-button"
                        title="Open source"
                        aria-label="Open todo source"
                        onClick={(event) => {
                          event.stopPropagation();
                          onOpenTodoItem(item);
                        }}
                      >
                        <ExternalLink size={14} />
                      </button>
                    ) : <span />}
                    <button
                      type="button"
                      className="todo-delete-button"
                      title="Delete todo"
                      aria-label="Delete todo"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDeleteTodo(item);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </article>
                );
              })}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
