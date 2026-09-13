import { AlertTriangle, RefreshCw } from "lucide-react";
import { api, type ConnectionSource, type ConnectionsPayload } from "../lib/api";
import { clock, day, relativeDay } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { SkeletonCards } from "../components/Avatar";
import { CopyField, EmptyState, ErrorRetry, Metric, PanelHeader, StatusPill, Surface } from "../components/ui";

/**
 * Connections — where the graph comes from, and how fresh it actually is.
 *
 * Freshness is read from the newest row in the graph, so a source that stopped
 * producing reads as stale with its real date. Each card carries the exact way to
 * refresh it, and the push log underneath shows every write that ever landed.
 */
export function ConnectionsScreen() {
  const result = useAsync<ConnectionsPayload>(() => api.connections(), []);
  const data = result.data;

  return (
    <div className="screen">
      <Surface>
        <PanelHeader
          eyebrow="Setup"
          title="Connections"
          detail={data?.summary.freshness_rule ?? "Where the graph comes from, and how fresh it is."}
          action={
            <button className="icon-button" title="Reload" onClick={result.reload}>
              <RefreshCw size={13} />
            </button>
          }
        />

        {result.error ? (
          <ErrorRetry message={result.error ?? undefined} onRetry={result.reload} />
        ) : !data ? (
          <SkeletonCards count={4} />
        ) : (
          <div className="grid-metrics conn-summary">
            <Metric label="Sources" value={data.summary.sources} />
            <Metric label="Fresh" value={data.summary.connected} tone="positive" />
            <Metric label="Stale" value={data.summary.stale} tone="warning" />
            <Metric label="Items in the graph" value={data.summary.items.toLocaleString()} />
          </div>
        )}
      </Surface>

      <Surface>
        <PanelHeader
          eyebrow="Sources"
          title="What the graph is made of"
          detail="Counts come from the rows themselves — the same numbers the People and Reconnect screens read."
        />
        {result.error ? null : !data ? (
          <SkeletonCards count={6} />
        ) : data.sources.length === 0 ? (
          <EmptyState title="No sources recorded" body="Nothing has pushed into this deployment yet." />
        ) : (
          <div className="conn-grid">
            {data.sources.map((source) => (
              <SourceCard source={source} key={source.id} />
            ))}
          </div>
        )}
      </Surface>

      <Surface>
        <PanelHeader
          eyebrow="Activity"
          title="Recent pushes"
          detail="Every write into the graph, newest first — a connector can be late, but it cannot hide."
        />
        {result.error ? null : !data ? (
          <SkeletonCards count={3} />
        ) : data.syncs.length === 0 ? (
          <EmptyState title="Nothing has been pushed yet" />
        ) : (
          <div className="sync-timeline">
            {data.syncs.map((sync, index) => (
              <div className="sync-row" key={`${sync.source}-${sync.pushed_at}-${index}`}>
                <span className="sync-when" title={sync.pushed_at}>
                  {relativeDay(sync.pushed_at)} · {clock(sync.pushed_at)}
                </span>
                <span className="sync-source">{sync.source}</span>
                <span className="pill">{sync.inserted.toLocaleString()} rows</span>
                <span className="sync-detail">{sync.detail || "—"}</span>
              </div>
            ))}
          </div>
        )}
      </Surface>
    </div>
  );
}

function SourceCard({ source }: { source: ConnectionSource }) {
  const age = source.freshness_days;
  const stale = source.status !== "connected" && source.status !== "not_configured";
  const width = age === null ? 0 : Math.min(100, Math.max(4, Math.round((age / 14) * 100)));
  const counts = [
    source.graph.messages ? `${source.graph.messages.toLocaleString()} messages` : "",
    source.graph.events ? `${source.graph.events.toLocaleString()} events` : "",
    source.graph.meetings ? `${source.graph.meetings.toLocaleString()} calls` : "",
    source.graph.records ? `${source.graph.records.toLocaleString()} records` : "",
  ].filter(Boolean);

  return (
    <div className={`surface conn-card${source.id === "ai" ? " ai" : ""}`} style={{ boxShadow: "none" }}>
      <div className="conn-card-head">
        <h3>{source.label}</h3>
        <StatusPill status={source.status} />
      </div>

      <p className="conn-detail">{source.detail}</p>

      {source.id !== "ai" ? (
        <div className="freshness">
          <div className="freshness-track">
            <span className={`freshness-bar${stale ? " stale" : ""}`} style={{ width: `${width}%` }} />
            <span className="freshness-threshold" title="3-day threshold" />
          </div>
          <div className="freshness-label">
            {age === null ? (
              <span>No dated rows yet</span>
            ) : age <= 3 ? (
              <span>Newest row {age === 0 ? "today" : `${age}d old`} — fresh</span>
            ) : (
              <span>
                Newest row {day(source.newest_item_at)} ({age}d old)
              </span>
            )}
          </div>
        </div>
      ) : null}

      <div className="conn-pills">
        {counts.length > 0 ? counts.map((count) => <span className="pill" key={count}>{count}</span>) : null}
        {counts.length === 0 && source.item_count > 0 ? (
          <span className="pill warning" title="The connector's own count — no matching rows are in the graph, so nothing is claimed here">
            claims {source.item_count.toLocaleString()} · none counted
          </span>
        ) : null}
        <span className="pill" title={source.last_sync_at ?? undefined}>
          {source.last_sync_at ? `synced ${relativeDay(source.last_sync_at)}` : "never synced"}
        </span>
      </div>

      {source.refresh.command ? (
        <CopyField title={`Refresh ${source.label}`} value={source.refresh.command} />
      ) : (
        <p className="conn-note">
          {source.refresh.kind === "none" && source.status !== "connected" ? (
            <AlertTriangle size={12} />
          ) : null}
          {source.refresh.note}
        </p>
      )}
      {source.refresh.command ? <p className="conn-note">{source.refresh.note}</p> : null}
    </div>
  );
}
