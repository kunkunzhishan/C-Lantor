import { Agent, Channel } from "../types";
import { AgentAvatar } from "./AgentAvatar";
import { Modal } from "./Modal";

type ChannelSettingsModalProps = {
  open: boolean;
  channel: Channel | null;
  agents: Agent[];
  channelMemberIds: Set<string>;
  nameDraft: string;
  descriptionDraft: string;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSetMember: (agentId: string, member: boolean) => void;
  onDelete: () => void;
  onCancel: () => void;
  onSave: () => void;
};

export function ChannelSettingsModal({
  open,
  channel,
  agents,
  channelMemberIds,
  nameDraft,
  descriptionDraft,
  onNameChange,
  onDescriptionChange,
  onSetMember,
  onDelete,
  onCancel,
  onSave,
}: ChannelSettingsModalProps) {
  return (
    <Modal
      open={open}
      title={channel ? `#${channel.name} Settings` : "Channel Settings"}
      onClose={onCancel}
      width={560}
      closeOnBackdrop={false}
      closeOnEscape={false}
    >
      {channel && (
        <div className="modal-form">
          <label>
            <span>Channel name</span>
            <input
              value={nameDraft}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="channel-name"
            />
          </label>
          <label>
            <span>Description</span>
            <textarea
              value={descriptionDraft}
              onChange={(event) => onDescriptionChange(event.target.value)}
              placeholder="Channel description"
            />
          </label>
          <div className="member-editor modal-member-editor channel-agent-picker">
            <strong>Agent members</strong>
            {agents.length === 0 && <span>No agents yet.</span>}
            {agents.map((agent) => {
              const isMember = channelMemberIds.has(agent.id);
              return (
                <label key={agent.id} className={`channel-agent-option ${isMember ? "selected" : ""}`}>
                  <input
                    className="channel-agent-checkbox"
                    type="checkbox"
                    checked={isMember}
                    onChange={(event) => onSetMember(agent.id, event.target.checked)}
                    aria-label={`${isMember ? "Remove" : "Add"} @${agent.handle}`}
                  />
                  <div className="channel-agent-profile">
                    <AgentAvatar agent={agent} size="sm" title={`@${agent.handle}`} />
                    <div className="agent-pick-row">
                      <strong>{agent.display_name}</strong>
                      <small>@{agent.handle}</small>
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
          <div className="modal-actions split">
            <button type="button" className="danger" onClick={onDelete}>Delete Channel</button>
            <div>
              <button type="button" onClick={onCancel}>Cancel</button>
              <button type="button" className="primary" disabled={!nameDraft.trim()} onClick={onSave}>Save</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
