import { Agent, Channel } from "../types";
import { AgentAvatar } from "./AgentAvatar";
import { Modal } from "./Modal";

type ChannelAgentsModalProps = {
  open: boolean;
  channel: Channel | null;
  agents: Agent[];
  channelMemberIds: Set<string>;
  onSetMember: (agentId: string, member: boolean) => void;
  onCreateAgent: () => void;
  onClose: () => void;
};

export function ChannelAgentsModal({
  open,
  channel,
  agents,
  channelMemberIds,
  onSetMember,
  onCreateAgent,
  onClose,
}: ChannelAgentsModalProps) {
  return (
    <Modal
      open={open}
      title={channel ? `Agents in #${channel.name}` : "Channel Agents"}
      onClose={onClose}
      width={560}
    >
      <div className="modal-form">
        <div className="member-editor modal-member-editor channel-agent-picker">
          {agents.length === 0 && <span>No agents yet. Create an agent first.</span>}
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
          <button onClick={onCreateAgent}>Create new agent</button>
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}
