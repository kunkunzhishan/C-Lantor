import { Type } from "lucide-react";
import { Modal } from "./Modal";

export type ChatTextSize = "compact" | "default" | "large" | "xlarge";

type SettingsModalProps = {
  open: boolean;
  chatTextSize: ChatTextSize;
  onChatTextSizeChange: (value: ChatTextSize) => void;
  onClose: () => void;
};

const CHAT_TEXT_SIZE_OPTIONS: Array<{
  value: ChatTextSize;
  label: string;
  detail: string;
}> = [
  { value: "compact", label: "Small", detail: "Compact UI" },
  { value: "default", label: "Default", detail: "Current scale" },
  { value: "large", label: "Large", detail: "More readable" },
  { value: "xlarge", label: "Extra", detail: "Largest" },
];

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
            {CHAT_TEXT_SIZE_OPTIONS.map((option) => (
              <button
                type="button"
                key={option.value}
                className={chatTextSize === option.value ? "selected" : ""}
                aria-pressed={chatTextSize === option.value}
                onClick={() => onChatTextSizeChange(option.value)}
              >
                <Type size={17} />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.detail}</small>
                </span>
              </button>
            ))}
          </div>
          <p className="settings-hint">Applies across messages, inputs, panels, and modals. Use Command/Ctrl+, to open Settings, Command/Ctrl +/- to adjust, and Command/Ctrl+0 to reset.</p>
        </fieldset>
      </section>
    </Modal>
  );
}
