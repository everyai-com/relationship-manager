import { api, type Connection } from "../lib/api";
import { useAsync } from "../lib/useAsync";
import { EmptyState, ErrorRetry, LoadingLine, PanelHeader, StatusPill, Surface } from "../components/ui";
import { relativeDay } from "../lib/format";

export function ConnectionsScreen() {
  const result = useAsync<{ connections: Connection[] }>(() => api.tool("connection_status", {}), []);
  const rows = result.data?.connections ?? [];

  return (
    <div className="screen">
      <Surface>
        <PanelHeader
          eyebrow="Setup"
          title="Connections"
          detail="Where this graph came from, and how fresh it is. A source that has not synced says so — the app never implies it knows more than it does."
        />

        {result.error ? (
          <ErrorRetry message={result.error} onRetry={result.reload} />
        ) : result.loading && !result.data ? (
          <LoadingLine />
        ) : rows.length === 0 ? (
          <EmptyState title="No sources recorded" body="Run the seed or push a sync from the local connectors." />
        ) : (
          <div className="grid-2">
            {rows.map((connection) => (
              <div className="surface" key={connection.id} style={{ boxShadow: "none" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
                  <h3 style={{ flex: 1 }}>{connection.label}</h3>
                  <StatusPill status={connection.status} />
                </div>
                <p style={{ fontSize: 12.5, color: "var(--gray-500)", margin: "var(--space-2) 0 var(--space-3)" }}>
                  {connection.detail}
                </p>
                <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap" }}>
                  <span className="pill">{connection.item_count.toLocaleString()} items</span>
                  <span className="pill">
                    {connection.last_sync_at ? `synced ${relativeDay(connection.last_sync_at)}` : "never synced"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </Surface>

      <Surface>
        <PanelHeader
          eyebrow="How syncing works"
          title="Live refresh runs locally, on purpose"
          detail="A Worker cannot hold a Gmail session or a WhatsApp pairing. The hosted app serves the graph; a local connector keeps it fresh."
        />
        <div className="code">
          <div className="code-head">
            <span className="code-title">Local connector (phase 2)</span>
          </div>
          {`# from the repo root
export REL_API=https://<your-worker>
export REL_KEY=rel_...            # an agent key with the write scope
python -m rel_sync gmail          # pushes new mail into /api/sync
python -m rel_sync whatsapp       # Baileys history (read-only ingest)
python -m rel_sync fathom         # recorded calls

# every push updates the connection row above — status, timestamp, item count`}
        </div>
      </Surface>
    </div>
  );
}
