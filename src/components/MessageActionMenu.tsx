import { Bookmark, Copy, Link, ListTodo, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";

type MessageActionMenuProps = {
  x: number;
  y: number;
  isSaved: boolean;
  isTodo: boolean;
  onCopyLink: () => void;
  onCopyMarkdown: () => void;
  onToggleSaved: () => void;
  onToggleTodo: () => void;
  onDelete: () => void;
  onClose: () => void;
};

export function MessageActionMenu({
  x,
  y,
  isSaved,
  isTodo,
  onCopyLink,
  onCopyMarkdown,
  onToggleSaved,
  onToggleTodo,
  onDelete,
  onClose,
}: MessageActionMenuProps) {
  const openedAtRef = useRef(Date.now());

  useEffect(() => {
    function handleClose() {
      if (Date.now() - openedAtRef.current < 350) return;
      onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("click", handleClose);
    window.addEventListener("scroll", handleClose, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("click", handleClose);
      window.removeEventListener("scroll", handleClose, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="message-action-menu"
      style={{
        left: Math.max(12, Math.min(x, window.innerWidth - 248)),
        top: Math.max(12, Math.min(y, window.innerHeight - 230)),
      }}
      onClick={(event) => event.stopPropagation()}
      role="menu"
    >
      <button type="button" onClick={onCopyLink}>
        <Link size={18} />
        <span>Copy link</span>
      </button>
      <button type="button" onClick={onCopyMarkdown}>
        <Copy size={18} />
        <span>Copy markdown</span>
      </button>
      <button type="button" onClick={onToggleSaved}>
        <Bookmark size={18} />
        <span>{isSaved ? "Unsave message" : "Save message"}</span>
      </button>
      <button type="button" onClick={onToggleTodo}>
        <ListTodo size={18} />
        <span>{isTodo ? "Remove todo" : "Add todo"}</span>
      </button>
      <button type="button" className="danger" onClick={onDelete}>
        <Trash2 size={18} />
        <span>Delete message</span>
      </button>
    </div>
  );
}
