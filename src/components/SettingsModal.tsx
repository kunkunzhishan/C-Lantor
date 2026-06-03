import { Type } from "lucide-react";
import { CHAT_TEXT_SIZE_LABELS, CHAT_TEXT_SIZE_OPTIONS, type ChatTextSize } from "../chatTextSize";
import { Modal } from "./Modal";

type SettingsModalProps = {
  open: boolean;
  chatTextSize: ChatTextSize;
  onChatTextSizeChange: (value: ChatTextSize) => void;
  onClose: () => void;
};

export function SettingsModal({
  open,
  chatTextSize,
  onChatTextSizeChange,
  onClose,
}: SettingsModalProps) {
  return (
    <Modal open={open} title="Settings" onClose={onClose} width={520}>
      <section className="settings-panel">
        <div className="settings-section-head">
          <h4>Appearance</h4>
        </div>
        <fieldset className="settings-fieldset">
          <legend>Text size</legend>
          <div className="chat-text-size-grid">
            {CHAT_TEXT_SIZE_OPTIONS.map((value) => {
              const option = CHAT_TEXT_SIZE_LABELS[value];
              return (
                <button
                  type="button"
                  key={value}
                  className={chatTextSize === value ? "selected" : ""}
                  aria-pressed={chatTextSize === value}
                  onClick={() => onChatTextSizeChange(value)}
                >
                  <Type size={17} />
                  <span>
                    <strong>{option.label}</strong>
                    <small>{option.detail}</small>
                  </span>
                </button>
              );
            })}
          </div>
          <p className="settings-hint">Applies across messages, inputs, panels, and modals. Use Command/Ctrl+, to open Settings, Command/Ctrl +/- to adjust, and Command/Ctrl+0 to reset.</p>
        </fieldset>
      </section>
    </Modal>
  );
}
