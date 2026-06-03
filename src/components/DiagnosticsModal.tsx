import { Activity, RotateCcw } from "lucide-react";
import { Modal } from "./Modal";

export type RefreshMetricsSnapshot = {
  startedAt: number;
  bootstrapCount: number;
  bootstrapByReason: Record<string, number>;
  bootstrapBySource: Record<string, number>;
  requestCount: number;
  requestByReason: Record<string, number>;
  coalescedRequestCount: number;
  coalescedRequestByReason: Record<string, number>;
  queuedRequestCount: number;
  queuedRequestByReason: Record<string, number>;
  stateUpdateCount: number;
  stateUpdateByReason: Record<string, number>;
  lastBootstrapAt: number | null;
  lastBootstrapReason: string | null;
  lastBootstrapDurationMs: number | null;
  averageBootstrapDurationMs: number | null;
};

type DiagnosticsModalProps = {
  open: boolean;
  metrics: RefreshMetricsSnapshot | null;
  onResetRefreshMetrics: () => void;
  onClose: () => void;
};

function ratePerMinute(count: number, startedAt: number) {
  const minutes = Math.max((Date.now() - startedAt) / 60_000, 1 / 60);
  return Number((count / minutes).toFixed(2));
}

function topEntries(bucket: Record<string, number>, limit = 6) {
  return Object.entries(bucket)
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit);
}

function formatRuntime(startedAt: number) {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatDuration(value: number | null | undefined) {
  if (typeof value !== "number") return "none";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

export function DiagnosticsModal({
  open,
  metrics,
  onResetRefreshMetrics,
  onClose,
}: DiagnosticsModalProps) {
  const requestReasons = metrics ? topEntries(metrics.requestByReason) : [];
  const bootstrapReasons = metrics ? topEntries(metrics.bootstrapByReason) : [];
  const stateUpdateReasons = metrics ? topEntries(metrics.stateUpdateByReason) : [];

  return (
    <Modal open={open} title="Diagnostics" onClose={onClose} width={620}>
      <section className="diagnostics-panel">
        <div className="diagnostics-head">
          <span className="diagnostics-icon" aria-hidden="true"><Activity size={18} /></span>
          <div>
            <h4>UI refresh metrics</h4>
            <p>Session refresh counts, reasons, and rates. Browser debug object: <code>window.__LANTOR_REFRESH_METRICS__</code>.</p>
          </div>
          <button type="button" onClick={onResetRefreshMetrics} title="Reset refresh metrics" aria-label="Reset refresh metrics">
            <RotateCcw size={15} />
          </button>
        </div>

        <div className="diagnostics-stats">
          <span>
            <strong>{metrics?.bootstrapCount ?? 0}</strong>
            <small>Bootstraps</small>
          </span>
          <span>
            <strong>{metrics ? `${ratePerMinute(metrics.bootstrapCount, metrics.startedAt)}/min` : "0/min"}</strong>
            <small>Bootstrap rate</small>
          </span>
          <span>
            <strong>{metrics?.requestCount ?? 0}</strong>
            <small>Requests</small>
          </span>
          <span>
            <strong>{metrics?.coalescedRequestCount ?? 0}</strong>
            <small>Coalesced</small>
          </span>
          <span>
            <strong>{metrics?.queuedRequestCount ?? 0}</strong>
            <small>Queued</small>
          </span>
          <span>
            <strong>{metrics?.stateUpdateCount ?? 0}</strong>
            <small>State updates</small>
          </span>
          <span>
            <strong>{formatDuration(metrics?.averageBootstrapDurationMs)}</strong>
            <small>Avg duration</small>
          </span>
          <span>
            <strong>{formatDuration(metrics?.lastBootstrapDurationMs)}</strong>
            <small>Last duration</small>
          </span>
        </div>

        <div className="diagnostics-meta">
          <span>Running {metrics ? formatRuntime(metrics.startedAt) : "0s"}</span>
          <span>Last full refresh: {metrics?.lastBootstrapReason ?? "none"}</span>
        </div>

        <div className="diagnostics-columns">
          <MetricList title="Refresh requests" entries={requestReasons} />
          <MetricList title="Full refreshes" entries={bootstrapReasons} />
          <MetricList title="State updates" entries={stateUpdateReasons} />
        </div>
      </section>
    </Modal>
  );
}

function MetricList({ title, entries }: { title: string; entries: Array<[string, number]> }) {
  return (
    <section className="diagnostics-list">
      <h5>{title}</h5>
      {entries.length === 0 ? (
        <p>No events yet.</p>
      ) : (
        <ol>
          {entries.map(([reason, count]) => (
            <li key={reason}>
              <span>{reason}</span>
              <strong>{count}</strong>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
